// Smoke test: the whole app renders with the bundled model (catches a broken artifact or a missing field at load time).
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, it } from 'vitest'
import App from '../App'

it('the app renders, incl. the economy forecast and what the R model learned', () => {
  const html = renderToString(createElement(App))
  expect(html).toContain('Forecast (Swiss data)')
  expect(html).toContain('What the model learned')
  expect(html).toContain('The economy forecast')
  expect(html).not.toContain('NaN')
})
