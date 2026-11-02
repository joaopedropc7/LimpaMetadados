import { useRef, useState } from 'react'
import { MAX_FILES } from '../useImageQueue'

export default function Dropzone({ count, onFiles, hint }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const full = count >= MAX_FILES

  return (
    <div
      className={`dropzone ${dragging ? 'dragging' : ''} ${full ? 'disabled' : ''}`}
      onClick={() => !full && inputRef.current.click()}
      onDragOver={(e) => {
        e.preventDefault()
        if (!full) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!full) onFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          onFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <strong>{full ? 'Limite atingido' : 'Arraste as imagens aqui ou clique para selecionar'}</strong>
      <span>
        {count}/{MAX_FILES} imagens · {hint}
      </span>
    </div>
  )
}
