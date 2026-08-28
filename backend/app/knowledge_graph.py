from __future__ import annotations
import csv, hashlib, json, math, os, re, zipfile
from io import BytesIO, StringIO
from pathlib import Path
from xml.etree import ElementTree as ET

RULES={"洗澡":["花洒","热水器"],"沐浴":["花洒","热水器"],"淋浴":["花洒","热水器"],"上厕所":["马桶"],"坐便":["马桶"],"洗衣":["洗衣机"],"洗衣服":["洗衣机"],"洗漱":["浴室柜"],"洗脸":["浴室柜"],"收纳":["浴室柜"]}

_ACCESSIBILITY_TERMS=("适老","老人","轮椅","扶手","坐浴")
_NEGATION_TERMS=("不需要","无需","不用","不要","没有","无","不是","非","不考虑","不含","排除","拒绝","取消")
_PUNCTUATION="，。；,;、\n"

def _has_positive_term(text:str,term:str)->bool:
    """Match an accessibility term only when the user's clause does not negate it."""
    start=0
    while (index:=text.find(term,start))>=0:
        clause_start=max((text.rfind(mark,0,index) for mark in _PUNCTUATION),default=-1)+1
        prefix=text[clause_start:index]
        suffix=text[index+len(term):]
        suffix=suffix[:8]
        if not any(prefix.rstrip().endswith(negation) for negation in _NEGATION_TERMS) and not re.match(r"^(?:需求|配置|功能)?(?:不需要|无需|不用|不要|没有|无|不考虑|不含|排除|拒绝|取消)",suffix):
            return True
        start=index+len(term)
    return False

def _accessibility_requested(text:str)->bool:
    return any(_has_positive_term(text,term) for term in _ACCESSIBILITY_TERMS)

def _partition_requested(text:str)->bool:
    return _has_positive_term(text,"淋浴隔断")

def equipment_rules(text:str)->dict[str,list[str]]:
    required=[item for phrase,items in RULES.items() if phrase in text for item in items]; accessible=_accessibility_requested(text)
    if accessible:
        required=[x for x in required if x!="浴室柜"]+["淋浴椅","花洒扶手","马桶扶手"]
        if any(x in text for x in ("洗漱","洗脸","轮椅")):required.append("适老浴室柜")
    shower=any(x in text for x in ("洗澡","沐浴","淋浴"))
    if accessible:
        optional=[];forbidden=["淋浴隔断"]
    elif _partition_requested(text):
        required.append("淋浴隔断");optional=[];forbidden=[]
    else:
        optional=["淋浴隔断"] if shower else [];forbidden=[]
    return {"必须设备":list(dict.fromkeys(required)),"可有可无设备":optional,"不能有的设备":forbidden}
def _xlsx(content:bytes)->list[list[str]]:
    ns="{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(BytesIO(content)) as z:
        shared=[]
        if "xl/sharedStrings.xml" in z.namelist():shared=["".join(n.text or "" for n in x.iter(ns+"t")) for x in ET.fromstring(z.read("xl/sharedStrings.xml"))]
        wb=ET.fromstring(z.read("xl/workbook.xml"));rel=ET.fromstring(z.read("xl/_rels/workbook.xml.rels"));targets={x.attrib["Id"]:x.attrib["Target"] for x in rel};rows=[]
        for sheet in wb.iter(ns+"sheet"):
            rid=sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id","");target=targets[rid];path=target.lstrip("/") if target.startswith("/") else "xl/"+target.lstrip("/")
            for row in ET.fromstring(z.read(path)).iter(ns+"row"):
                values=[]
                for cell in row.findall(ns+"c"):
                    letters=re.match(r"[A-Z]+",cell.attrib.get("r","A1")).group(0);index=0
                    for char in letters:index=index*26+ord(char)-64
                    values += [""]*(index-len(values));node=cell.find(ns+"v");value=node.text if node is not None and node.text else ""
                    if cell.attrib.get("t")=="s" and value.isdigit():value=shared[int(value)]
                    elif cell.attrib.get("t")=="inlineStr":value="".join(n.text or "" for n in cell.iter(ns+"t"))
                    values[index-1]=value.strip()
                if any(values):rows.append(values)
        return rows
class ProductKnowledgeGraph:
    RRF_K=60
    RRF_WEIGHTS={"bm25":1.0,"vector":1.0,"graph":1.0}
    _embedding_model=None
    _embedding_cache={}
    def __init__(self,path:Path):self.path=path
    def load(self):return json.loads(self.path.read_text("utf-8")) if self.path.is_file() else {"version":2,"products":{},"entities":{},"relations":[]}
    def product_by_code(self, code:str):
        normalized=code.strip()
        return next((p for p in self.load()["products"].values() if p.get("active",True) and p.get("attributes",{}).get("材料编号")==normalized),None)
    def catalog_options(self):
        """Return active products in deterministic category/model selection order."""
        products=[];categories=[]
        for product in self.load().get("products",{}).values():
            if not product.get("active",True):continue
            attributes={str(key):str(value) for key,value in product.get("attributes",{}).items()}
            code=attributes.get("材料编号","").strip();category=attributes.get("材料名称","").strip()
            if not code or not category:continue
            if category not in categories:categories.append(category)
            products.append({
                "id":str(product.get("id") or ""),"code":code,"category":category,
                "model":attributes.get("规格型号","").strip() or attributes.get("物品名称","").strip() or code,
                "price":attributes.get("单价","").strip(),"unit":attributes.get("数量单位","").strip(),
                "attributes":attributes,
            })
        return {"categories":categories,"products":products}
    def create_product(self, attributes:dict[str,str]):
        record={str(k).strip():str(v).strip() for k,v in attributes.items() if str(k).strip() and str(v).strip()}
        code=record.get("材料编号","");category=record.get("材料名称","")
        if not code or not category:raise ValueError("新增产品必须提供材料编号和材料名称")
        if self.product_by_code(code):raise ValueError("该 SKU 已存在，请直接绑定")
        graph=self.load();pid=hashlib.sha256(f"{code}|{category}".encode()).hexdigest()[:20]
        digest=hashlib.sha256(json.dumps(record,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
        graph["products"][pid]={"id":pid,"digest":digest,"active":True,"attributes":record}
        self._rebuild_relations(graph);self.path.parent.mkdir(parents=True,exist_ok=True)
        self.path.write_text(json.dumps(graph,ensure_ascii=False,indent=2),"utf-8")
        return graph["products"][pid]
    def ensure_products(self, records:list[dict[str,str]]):
        """Add newly shipped baseline products without replacing user graph entries."""
        graph=self.load();products=graph["products"]
        existing_codes={p.get("attributes",{}).get("材料编号","").strip() for p in products.values()}
        created=0
        for attributes in records:
            record={str(k).strip():str(v).strip() for k,v in attributes.items() if str(k).strip() and str(v).strip()}
            code=record.get("材料编号","");category=record.get("材料名称","")
            if not code or not category or code in existing_codes:continue
            pid=hashlib.sha256(f"{code}|{category}".encode()).hexdigest()[:20]
            digest=hashlib.sha256(json.dumps(record,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
            products[pid]={"id":pid,"digest":digest,"active":True,"attributes":record}
            existing_codes.add(code);created+=1
        if created:
            self._rebuild_relations(graph);self.path.parent.mkdir(parents=True,exist_ok=True)
            self.path.write_text(json.dumps(graph,ensure_ascii=False,indent=2),"utf-8")
        return created
    def sync_baseline_categories(self, records:list[dict[str,str]], categories:set[str], stale_prefixes:tuple[str,...]=()):
        """Upsert corrected baseline rows and retire known stale codes in those categories."""
        graph=self.load();products=graph["products"];changed=False;created=updated=deactivated=0
        for product in products.values():
            attrs=product.get("attributes",{});code=str(attrs.get("材料编号","")).strip();category=str(attrs.get("材料名称","")).strip()
            if category in categories and stale_prefixes and code.startswith(stale_prefixes) and product.get("active",True):
                product["active"]=False;changed=True;deactivated+=1
        for attributes in records:
            record={str(k).strip():str(v).strip() for k,v in attributes.items() if str(k).strip() and str(v).strip()}
            code=record.get("材料编号","");category=record.get("材料名称","")
            if not code or category not in categories:continue
            pid=hashlib.sha256(f"{code}|{category}".encode()).hexdigest()[:20]
            digest=hashlib.sha256(json.dumps(record,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
            replacement={"id":pid,"digest":digest,"active":True,"attributes":record}
            if pid not in products:created+=1
            elif products[pid]!=replacement:updated+=1
            else:continue
            products[pid]=replacement;changed=True
        if changed:
            self._rebuild_relations(graph);self.path.parent.mkdir(parents=True,exist_ok=True)
            self.path.write_text(json.dumps(graph,ensure_ascii=False,indent=2),"utf-8")
        return {"created":created,"updated":updated,"deactivated":deactivated}
    @staticmethod
    def _terms(text:str):
        chunks=[x.lower() for x in re.findall(r"[\w\u4e00-\u9fff]+",text) if len(x)>1]
        return [part for chunk in chunks for part in ([chunk] if len(chunk)<=2 else [chunk,*[chunk[i:i+2] for i in range(len(chunk)-1)]])]
    @staticmethod
    def _entity_id(kind:str,value:str):return hashlib.sha256(f"{kind}|{value}".encode()).hexdigest()[:20]
    @classmethod
    def _vector_ranking(cls,query:str,products:list[dict])->list[str]:
        """Optional free local semantic branch; absence/failure degrades to BM25+graph."""
        model_name=os.getenv("EMBEDDING_MODEL","").strip()
        if not model_name:return []
        try:
            if cls._embedding_model is None:
                from fastembed import TextEmbedding
                cls._embedding_model=TextEmbedding(model_name=model_name,cache_dir=os.getenv("EMBEDDING_CACHE_DIR") or None)
            documents=[" ".join(product["attributes"].values()) for product in products]
            cache_key=hashlib.sha256((model_name+"\0"+"\0".join(documents)).encode()).hexdigest()
            if cache_key not in cls._embedding_cache:
                cls._embedding_cache={cache_key:list(cls._embedding_model.embed(documents))}
            query_vector=next(iter(cls._embedding_model.query_embed(query)))
            scores=[(float(query_vector@vector),product["id"]) for vector,product in zip(cls._embedding_cache[cache_key],products)]
            return [pid for _,pid in sorted(scores,reverse=True)]
        except Exception:
            return []
    def _rebuild_relations(self,graph):
        """Materialize a small, deterministic property graph from catalog fields."""
        entities={};relations=[]
        relation_fields={"材料名称":"CATEGORY","人群":"AUDIENCE","风格":"STYLE","规格型号":"SPEC","点位类型":"FIXTURE_KIND"}
        for product in graph["products"].values():
            if not product.get("active",True):continue
            entities[product["id"]]={"id":product["id"],"type":"PRODUCT","label":product["attributes"].get("物品名称") or product["attributes"].get("材料名称",product["id"])}
            for field,kind in relation_fields.items():
                for value in re.split(r"[、,，/；;\s]+",product["attributes"].get(field,"").strip()):
                    if not value:continue
                    eid=self._entity_id(kind,value);entities[eid]={"id":eid,"type":kind,"label":value}
                    relations.append({"from":product["id"],"type":f"HAS_{kind}","to":eid})
        graph.update({"version":2,"entities":entities,"relations":relations})
    def import_catalog(self,filename:str,content:bytes):
        rows=_xlsx(content) if filename.lower().endswith(".xlsx") else list(csv.reader(StringIO(content.decode("utf-8-sig")))) if filename.lower().endswith(".csv") else None
        if not rows or len(rows)<2:raise ValueError("仅支持含数据的 .xlsx 或 .csv 产品清单")
        # The source workbook uses one logical remark for rows 1-9 and another
        # for rows 10-18.  Excel display/merge artefacts can make the values
        # appear different, so normalize each group before building records.
        remark_index=next((i for i,value in enumerate(rows[0]) if value.strip()=="备注"),None)
        if remark_index is not None:
            for start,end in ((1,10),(10,19)):
                canonical=next((row[remark_index].strip() for row in rows[start:end] if len(row)>remark_index and row[remark_index].strip()),"")
                if canonical:
                    for row in rows[start:end]:
                        row.extend([""]*(remark_index+1-len(row)));row[remark_index]=canonical
        headers=[x.strip() or f"字段{i+1}" for i,x in enumerate(rows[0])];graph=self.load();products=graph["products"];seen=set();counts={"created":0,"updated":0,"unchanged":0}
        for row in rows[1:]:
            record={headers[i]:x.strip() for i,x in enumerate(row[:len(headers)]) if x.strip()}
            if not record:continue
            code=next((record[k] for k in headers if any(x in k.lower() for x in ("sku","编号","编码","货号")) and record.get(k)),"")
            category=next((record[k] for k in headers if any(x in k for x in ("材料名称","品类","类别")) and record.get(k)),"")
            natural="|".join((code,category)) if code else json.dumps(record,ensure_ascii=False,sort_keys=True)
            pid=hashlib.sha256(natural.encode()).hexdigest()[:20];digest=hashlib.sha256(json.dumps(record,ensure_ascii=False,sort_keys=True).encode()).hexdigest();seen.add(pid)
            state="created" if pid not in products else "unchanged" if products[pid]["digest"]==digest else "updated";counts[state]+=1;products[pid]={"id":pid,"digest":digest,"active":True,"attributes":record}
        deactivated=0
        for pid,product in products.items():
            if pid not in seen and product.get("active",True):product["active"]=False;deactivated+=1
        self._rebuild_relations(graph)
        self.path.parent.mkdir(parents=True,exist_ok=True);self.path.write_text(json.dumps(graph,ensure_ascii=False,indent=2),"utf-8");return {**counts,"deactivated":deactivated,"total":len(seen)}
    def search(self,query:str,limit:int=12):
        graph=self.load();products=[p for p in graph["products"].values() if p.get("active",True)];terms=self._terms(query)
        if not terms:return []
        docs={p["id"]:self._terms(" ".join(p["attributes"].values())) for p in products};n=max(len(docs),1)
        df={term:sum(term in set(tokens) for tokens in docs.values()) for term in set(terms)};avgdl=sum(map(len,docs.values()))/n or 1
        lexical=[]
        for product in products:
            tokens=docs[product["id"]];score=0.0
            for term in terms:
                tf=tokens.count(term)
                if tf:score += math.log(1+(n-df[term]+.5)/(df[term]+.5))*(tf*2.2)/(tf+1.2*(.25+.75*len(tokens)/avgdl))
            values={v.lower() for v in product["attributes"].values()}
            if any(term in values for term in terms):score+=8
            if any(term in product["id"].lower() for term in terms):score+=50
            if score:lexical.append((score,product["id"]))
        lexical_ids=[pid for _,pid in sorted(lexical,reverse=True)]
        # Graph branch: match category/audience/style/spec entities and traverse
        # their incoming HAS_* edges back to products.
        matching={eid for eid,e in graph.get("entities",{}).items() if e.get("type")!="PRODUCT" and any(t in e.get("label","").lower() for t in terms)}
        graph_ids=[]
        for edge in graph.get("relations",[]):
            if edge["to"] in matching and edge["from"] not in graph_ids:graph_ids.append(edge["from"])
        # Reciprocal-rank fusion keeps exact lexical matches while adding graph
        # neighbors; return an auditable retrieval trace with every product.
        vector_ids=self._vector_ranking(query,products)
        scores={}
        for name,ranking in (("bm25",lexical_ids),("vector",vector_ids),("graph",graph_ids)):
            for rank,pid in enumerate(ranking,1):scores[pid]=scores.get(pid,0)+self.RRF_WEIGHTS[name]/(self.RRF_K+rank)
        by_id={p["id"]:p for p in products};result=[]
        for pid in sorted(scores,key=lambda x:scores[x],reverse=True)[:limit]:
            branches=[name for name,ranking in (("bm25",lexical_ids),("vector",vector_ids),("graph",graph_ids)) if pid in ranking]
            item=dict(by_id[pid]);item["retrieval"]={"method":"hybrid_rrf","branches":branches,"rrf_k":self.RRF_K,"weights":self.RRF_WEIGHTS,"score":round(scores[pid],6),"source":f"product_catalog:{pid}"};result.append(item)
        return result
    def search_constrained(self,query:str,limit:int=12,allowed_categories:set[str]|None=None,forbidden:set[str]|None=None):
        """Apply hard business constraints after fuzzy retrieval; forbidden wins."""
        forbidden=forbidden or set();result=[]
        for product in self.search(query,limit=max(limit*4,24)):
            category=product["attributes"].get("材料名称","")
            if category in forbidden or (allowed_categories is not None and category not in allowed_categories):continue
            result.append(product)
            if len(result)>=limit:break
        return result
