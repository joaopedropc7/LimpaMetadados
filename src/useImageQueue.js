import { useCallback, useEffect, useRef, useState } from 'react'

export const MAX_FILES = 30

const isImage = (f) => f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name)
const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|3gp|webm|mkv)$/i.test(f.name)

// Lista de até MAX_FILES imagens/vídeos, cada item processado por `process` ao entrar
export function useImageQueue(process) {
  const [items, setItems] = useState([])
  const [warning, setWarning] = useState('')
  const itemsRef = useRef(items)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // Libera as URLs de pré-visualização ao desmontar
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), [])

  const updateItem = (id, patch) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))

  const addFiles = useCallback(
    (fileList) => {
      const files = [...fileList]
      const media = files.filter((f) => isImage(f) || isVideo(f))
      const free = MAX_FILES - itemsRef.current.length
      const accepted = media.slice(0, Math.max(free, 0))

      const ignored = files.length - accepted.length
      setWarning(
        ignored > 0
          ? `${ignored} arquivo(s) ignorado(s): limite de ${MAX_FILES} arquivos ou formato que não é imagem/vídeo.`
          : '',
      )

      const newItems = accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        preview: URL.createObjectURL(file),
        video: isVideo(file),
        status: 'processing',
      }))
      itemsRef.current = [...itemsRef.current, ...newItems]
      setItems(itemsRef.current)

      newItems.forEach(async (item) => {
        try {
          const result = await process(item.file)
          updateItem(item.id, { status: 'done', result })
        } catch (err) {
          updateItem(item.id, { status: 'error', error: err.message })
        }
      })
    },
    [process],
  )

  function removeItem(id) {
    setItems((prev) => {
      const item = prev.find((i) => i.id === id)
      if (item) URL.revokeObjectURL(item.preview)
      return prev.filter((i) => i.id !== id)
    })
    setWarning('')
  }

  function clearAll() {
    items.forEach((i) => URL.revokeObjectURL(i.preview))
    setItems([])
    setWarning('')
  }

  return { items, warning, addFiles, removeItem, clearAll }
}
