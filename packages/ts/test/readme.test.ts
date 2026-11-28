// The README's caller-side code ("What the caller adapts" and "Replacing the
// ical.ts converters") is the code of examples/caller-adapters.ts, which
// `npm run typecheck` compiles.
import * as fs from 'fs'
import * as path from 'path'

it('the README adapters are the compiled examples', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../../README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('### What the caller adapts'), readme.indexOf('## Performance'))
  const blocks = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1])
  expect(blocks.length).toBeGreaterThanOrEqual(4)
  const example = fs.readFileSync(path.join(__dirname, '../examples/caller-adapters.ts'), 'utf8')
  const lines = new Set(example.split('\n').map((l) => l.trim()))
  const missing = blocks.flatMap((b) => b.split('\n').map((l) => l.trim()).filter((l) => l && !lines.has(l)))
  expect(missing).toEqual([])
})
