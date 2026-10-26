'use strict'
/**
 * dsh-infer-kit — client half (web GUI artifact, no build).
 * One status button in the sidebar footer: shows cache/cascade counters.
 * Contract: window.__ModuleLoader__.load({ id: '<package name>', factory })
 * with exports.apply + exports.inject = ['slots'].
 */
window.__ModuleLoader__.load({
  id: 'dsh-infer-kit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    function StatusButton (props) {
      const wide = !!(props && props.wide)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(() => {
        fetch('/infer-kit/status')
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => setStatus(j))
          .catch(() => setStatus(null))
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const onClick = () => {
        if (wide && !busy) {
          setBusy(true)
          fetch('/infer-kit/status')
            .then((r) => r.json())
            .then((j) => setStatus(j))
            .catch(() => {})
            .finally(() => setBusy(false))
        }
      }

      const label = !status
        ? 'InferKit —'
        : status.entries + '·' + status.hits + '/' + (status.hits + status.misses)

      const title = !status
        ? 'dsh-infer-kit: status unavailable'
        : 'dsh-infer-kit\nentries: ' + status.entries +
          '\ncache hits: ' + status.hits + ' / ' + (status.hits + status.misses) +
          '\ncascade uses: ' + status.cascadeUses +
          '\ndraft endpoint: ' + (status.draftConfigured ? 'yes' : 'not configured')

      return h('button', {
        type: 'button',
        title: title,
        onClick: onClick,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: wide ? 'pointer' : 'default',
          fontSize: '12px',
          opacity: 0.9,
        },
      },
      wide
        ? [
            h('span', { key: 'i', style: { fontSize: '13px' } }, '⚡'),
            h('span', { key: 't' }, 'InferKit ' + label),
          ]
        : [h('span', { key: 'i', title: title }, '⚡')])
    }

    function apply (ctx) {
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-infer-kit',
          order: 62,
          label: 'InferKit',
        }, StatusButton))
      } catch (e) {
        // never break the shell boot because of a cosmetic button
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
