import { useImperativeHandle } from 'react'
import { inspectMetadata } from '../lib/inspectMetadata'
import { useImageQueue } from '../useImageQueue'
import Dropzone, { Preview } from './Dropzone'

const VERDICTS = {
  clean: { label: 'Limpa', text: 'Nenhum metadado identificável encontrado.' },
  dirty: { label: 'Contém metadados', text: 'Há informações embutidas no arquivo.' },
  ai: { label: 'Indícios de IA', text: 'Os metadados indicam geração ou edição por IA.' },
  unknown: { label: 'Não analisada', text: '' },
}

const SIGNAL_TITLES = {
  ai: 'Inteligência artificial',
  provenance: 'Procedência',
  privacy: 'Privacidade',
  info: 'Aviso',
}

function groupEntries(entries) {
  const groups = {}
  for (const e of entries) (groups[e.group] ??= []).push(e)
  return Object.entries(groups)
}

function Report({ result }) {
  const verdict = VERDICTS[result.verdict]
  const visible = result.entries.filter((e) => !e.technical)
  const technical = result.entries.filter((e) => e.technical)

  return (
    <>
      <div className={`verdict ${result.verdict}`}>
        <strong>{verdict.label}</strong>
        {verdict.text && <span>{verdict.text}</span>}
      </div>

      {result.signals.length > 0 && (
        <ul className="signals">
          {result.signals.map((s) => (
            <li key={s.text} className={s.level}>
              <b>{SIGNAL_TITLES[s.level]}:</b>{' '}
              {s.link ? (
                <a href={s.link} target="_blank" rel="noreferrer">
                  {s.text}
                </a>
              ) : (
                s.text
              )}
            </li>
          ))}
        </ul>
      )}

      {visible.length > 0 && (
        <details>
          <summary>Ver todos os metadados ({visible.length})</summary>
          {groupEntries(visible).map(([group, entries]) => (
            <table key={group} className="meta-table">
              <caption>{group}</caption>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <th>{e.key}</th>
                    <td>{e.value.length > 300 || e.value.includes('\n') ? <pre>{e.value}</pre> : e.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </details>
      )}

      {technical.length > 0 && (
        <p className="technical">
          Dados técnicos mantidos (não identificam você): {technical.map((e) => e.key).join(', ')}
        </p>
      )}
    </>
  )
}

export default function Inspector({ ref }) {
  const { items, warning, addFiles, removeItem, clearAll } = useImageQueue(inspectMetadata)

  // Permite que a aba de limpeza envie arquivos para verificação
  useImperativeHandle(ref, () => ({ addFiles }), [addFiles])

  const done = items.filter((i) => i.status === 'done')
  const counts = { clean: 0, dirty: 0, ai: 0 }
  done.forEach((i) => counts[i.result.verdict]++)

  return (
    <>
      <Dropzone count={items.length} onFiles={addFiles} hint="Análise feita no navegador, nada é alterado" />

      <p className="note">
        A verificação lê os metadados do arquivo (EXIF, GPS, XMP, IPTC, C2PA, textos de PNG e, em vídeos, QuickTime,
        trilhas de GPS/sensores e tags WebM/MKV). Marcas d&apos;água invisíveis gravadas na imagem, como o SynthID do
        Google, não aparecem nos metadados e não podem ser detectadas
        nem removidas aqui.
      </p>

      {warning && <p className="warning">{warning}</p>}

      {items.length > 0 && (
        <>
          <div className="toolbar">
            <span className="summary">
              {done.length > 0 && (
                <>
                  <em className="clean">{counts.clean} limpas</em>
                  <em className="dirty">{counts.dirty} com metadados</em>
                  <em className="ai">{counts.ai} com indícios de IA</em>
                </>
              )}
            </span>
            <button className="secondary" onClick={clearAll}>
              Limpar lista
            </button>
          </div>

          <ul className="report-list">
            {items.map((item) => (
              <li key={item.id} className={`card report ${item.status}`}>
                <Preview item={item} />
                <div className="info">
                  <span className="name" title={item.file.name}>
                    {item.file.name}
                  </span>
                  {item.status === 'processing' && <span className="muted">Analisando…</span>}
                  {item.status === 'error' && <span className="error">{item.error}</span>}
                  {item.status === 'done' && <Report result={item.result} />}
                </div>
                <div className="card-actions">
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
