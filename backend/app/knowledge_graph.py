from __future__ import annotations
import csv, hashlib, json, re, zipfile
from io import BytesIO, StringIO
from pathlib import Path
from xml.etree import ElementTree as ET

RULES={"洗澡":["花洒","热水器"],"沐浴":["花洒","热水器"],"淋浴":["花洒","热水器"],"上厕所":["马桶"],"坐便":["马桶"],"洗衣":["洗衣机"],"洗衣服":["洗衣机"],"洗漱":["浴室柜"],"洗脸":["浴室柜"]}
def equipment_rules(text:str)->dict[str,list[str]]:
    required=[item for phrase,items in RULES.items() if phrase in text for item in items]; accessible=any(x in text for x in ("适老","老人","轮椅","扶手"))
    if accessible:
        required=[x for x in required if x!="浴室柜"]+["淋浴椅","花洒扶手","马桶扶手"]
        if any(x in text for x in ("洗漱","洗脸","轮椅")):required.append("适老浴室柜")
    shower=any(x in text for x in ("洗澡","沐浴","淋浴"))
    return {"必须设备":list(dict.fromkeys(required)),"可有可无设备":[] if accessible else (["淋浴隔断"] if shower else []),"不能有的设备":["淋浴隔断"] if accessible else []}
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
    def __init__(self,path:Path):self.path=path
    def load(self):return json.loads(self.path.read_text("utf-8")) if self.path.is_file() else {"version":1,"products":{}}
    def import_catalog(self,filename:str,content:bytes):
        rows=_xlsx(content) if filename.lower().endswith(".xlsx") else list(csv.reader(StringIO(content.decode("utf-8-sig")))) if filename.lower().endswith(".csv") else None
        if not rows or len(rows)<2:raise ValueError("仅支持含数据的 .xlsx 或 .csv 产品清单")
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
        self.path.parent.mkdir(parents=True,exist_ok=True);self.path.write_text(json.dumps(graph,ensure_ascii=False,indent=2),"utf-8");return {**counts,"deactivated":deactivated,"total":len(seen)}
    def search(self,query:str,limit:int=12):
        chunks=[x.lower() for x in re.findall(r"[\w\u4e00-\u9fff]+",query) if len(x)>1]
        terms={part for chunk in chunks for part in ([chunk] if len(chunk)<=2 else [chunk,*[chunk[i:i+2] for i in range(len(chunk)-1)]])};ranked=[]
        for product in self.load()["products"].values():
            values=[value.lower() for value in product["attributes"].values()]
            text=" ".join(values);score=sum(x in text for x in terms)+4*sum(value in terms for value in values)
            audience=product["attributes"].get("人群","").lower()
            if audience and audience in terms:score+=20
            if score and product.get("active",True):ranked.append((score,product))
        return [x for _,x in sorted(ranked,key=lambda x:x[0],reverse=True)[:limit]]
