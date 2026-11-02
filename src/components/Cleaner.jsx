import { useState } from 'react'
import JSZip from 'jszip'
import { stripMetadata } from '../lib/stripMetadata'
import { useImageQueue } from '../useImageQueue'
import Dropzone, { Preview } from './Dropzone'

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 1
  while (used.has(`${base} (${i})${ext}`)) i++
  const result = `${base} (${i})${ext}`
  used.add(result)
  return result
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Cleaner({ onInspect }) {
  const { items, warning, addFiles, removeItem, clearAll } = useImageQueue(stripMetadata)
  const [zipping, setZipping] = useState(false)

  const done = items.filter((i) => i.status === 'done')
  const processing = items.some((i) => i.status === 'processing')

  async function downloadZip() {
    setZipping(true)
    try {
      const zip = new JSZip()
      const used = new Set()
      for (const item of done) zip.file(uniqueName(item.result.name, used), item.result.blob)
      // Sem compressão: imagens e vídeos já são comprimidos
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      downloadBlob(blob, 'arquivos-sem-metadados.zip')
    } finally {
      setZipping(false)
    }
  }

  function inspectCleaned() {
    onInspect(done.map((i) => new File([i.result.blob], i.result.name, { type: i.result.blob.type })))
  }

  return (
    <>
      <Dropzone count={items.length} onFiles={addFiles} hint="Imagens (JPEG, PNG, WebP, GIF) e vídeos (MP4, MOV, WebM, MKV) sem perda de qualidade" />

      {warning && <p className="warning">{warning}</p>}

      {items.length > 0 && (
        <>
          <div className="toolbar">
            <span>
              {done.length} de {items.length} prontas
            </span>
            <div className="actions">
              <button className="secondary" onClick={clearAll}>
                Limpar lista
              </button>
              <button className="secondary" onClick={inspectCleaned} disabled={processing || done.length === 0}>
                Verificar resultado
              </button>
              <button onClick={downloadZip} disabled={processing || zipping || done.length === 0}>
                {zipping ? 'Gerando ZIP…' : `Baixar ZIP (${done.length})`}
              </button>
            </div>
          </div>

          <ul className="grid">
            {items.map((item) => (
              <li key={item.id} className={`card ${item.status}`}>
                <Preview item={item} />
                <div className="info">
                  <span className="name" title={item.file.name}>
                    {item.file.name}
                  </span>
                  {item.status === 'processing' && <span className="muted">Processando…</span>}
                  {item.status === 'error' && <span className="error">{item.error}</span>}
                  {item.status === 'done' && (
                    <>
                      <span className="muted">
                        {formatSize(item.file.size)} → {formatSize(item.result.blob.size)}
                      </span>
                      <span className="tags">
                        {item.result.removed.length > 0 ? (
                          item.result.removed.map((r) => <em key={r}>{r}</em>)
                        ) : (
                          <span className="muted">Nenhum metadado encontrado</span>
                        )}
                      </span>
                    </>
                  )}
                </div>
                <div className="card-actions">
                  {item.status === 'done' && (
                    <button
                      className="icon"
                      title="Baixar este arquivo"
                      onClick={() => downloadBlob(item.result.blob, item.result.name)}
                    >
                      ↓
                    </button>
                  )}
                  <button className="icon" title="Remover" onClick={() => removeItem(item.id)}>
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
