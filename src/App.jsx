import { useRef, useState } from 'react'
import Cleaner from './components/Cleaner'
import Inspector from './components/Inspector'

const TABS = [
  { id: 'clean', label: 'Limpar' },
  { id: 'inspect', label: 'Verificar' },
]

export default function App() {
  const [tab, setTab] = useState('clean')
  const inspectorRef = useRef(null)

  function inspectFiles(files) {
    setTab('inspect')
    inspectorRef.current.addFiles(files)
  }

  return (
    <main className="app">
      <header>
        <h1>Limpador de Metadados</h1>
        <p className="subtitle">
          Remove EXIF, GPS, XMP, IPTC, C2PA e comentários das suas imagens e vídeos e verifica se sobrou algo,
          inclusive marcações de IA. Tudo acontece no seu navegador — nada é enviado para servidor.
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* As duas abas ficam montadas para não perder a lista ao alternar */}
      <section hidden={tab !== 'clean'}>
        <Cleaner onInspect={inspectFiles} />
      </section>
      <section hidden={tab !== 'inspect'}>
        <Inspector ref={inspectorRef} />
      </section>
    </main>
  )
}
