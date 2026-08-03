export interface ModelImportFile {
  file: File
  path: string
}

type FileSystemEntryLike = {
  isFile: boolean
  isDirectory: boolean
  name: string
}

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void
}

type FileSystemDirectoryReaderLike = {
  readEntries: (success: (entries: FileSystemEntryLike[]) => void, failure?: (error: DOMException) => void) => void
}

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => FileSystemDirectoryReaderLike
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null
}

export const modelPrimaryExtensions = ['glb', 'gltf', 'fbx', '3ds', 'obj'] as const
const dependencyExtensions = new Set([
  ...modelPrimaryExtensions,
  'bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'dds', 'ktx', 'ktx2', 'basis',
])
const ignoredNames = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function extension(path: string) {
  return path.split('.').at(-1)?.toLowerCase() ?? ''
}

export function inputFiles(fileList: FileList | File[]): ModelImportFile[] {
  return Array.from(fileList)
    .filter((file) => !ignoredNames.has(file.name.toLowerCase()))
    .map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }))
}

function fileFromEntry(entry: FileSystemFileEntryLike, path: string) {
  return new Promise<ModelImportFile>((resolve, reject) => {
    entry.file((file) => resolve({ file, path }), reject)
  })
}

function readDirectory(reader: FileSystemDirectoryReaderLike) {
  return new Promise<FileSystemEntryLike[]>((resolve, reject) => {
    const allEntries: FileSystemEntryLike[] = []
    const readBatch = () => reader.readEntries((entries) => {
      if (!entries.length) resolve(allEntries)
      else {
        allEntries.push(...entries)
        readBatch()
      }
    }, reject)
    readBatch()
  })
}

async function walkEntry(entry: FileSystemEntryLike, parentPath = ''): Promise<ModelImportFile[]> {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name
  if (entry.isFile) {
    if (ignoredNames.has(entry.name.toLowerCase())) return []
    return [await fileFromEntry(entry as FileSystemFileEntryLike, path)]
  }
  if (!entry.isDirectory) return []
  const children = await readDirectory((entry as FileSystemDirectoryEntryLike).createReader())
  return (await Promise.all(children.map((child) => walkEntry(child, path)))).flat()
}

export async function droppedModelFiles(dataTransfer: DataTransfer): Promise<ModelImportFile[]> {
  const entries: FileSystemEntryLike[] = []
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue
    const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.()
    if (entry) entries.push(entry as unknown as FileSystemEntryLike)
  }
  if (!entries.length) return inputFiles(dataTransfer.files)
  return (await Promise.all(entries.map((entry) => walkEntry(entry)))).flat()
}

export function validateModelImport(entries: ModelImportFile[]) {
  if (!entries.length) throw new Error('没有找到可上传的模型文件。')
  const unsupported = entries.find((entry) => !dependencyExtensions.has(extension(entry.path)))
  if (unsupported) throw new Error(`模型文件夹包含不支持的文件：${unsupported.path}`)
  const primary = entries.filter((entry) => modelPrimaryExtensions.includes(extension(entry.path) as typeof modelPrimaryExtensions[number]))
  if (primary.length !== 1) throw new Error('每次请选择一个主模型；GLTF 的 BIN 与纹理可以一起上传。')
  return primary[0]
}
