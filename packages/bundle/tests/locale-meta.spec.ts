import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dsh Plugins page reads a bundle card's title and each patch row's
 * title through the same package-meta contract: `locale/en.json` is the
 * anchor, sibling `locale/<lang>.json` files supply translations keyed by
 * their lowercase filename, and every locale file must resolve through the
 * package's `exports` glob — an existing but unexported sibling is a
 * metadata error on the page, and an unexported locale directory is a
 * silent skip back to bare module names. This spec keeps all five
 * packages on the working side of that contract.
 */
const PACKAGE_DIRS = ['bundle', 'service', 'sqlite', 'tree-sitter', 'tool'] as const

/** Row `name` values the bundle patch declares; each row's package carries its own locale meta. */
const ROW_NAMES = [
  '@huanlin/dsh-plugin-codegraph-service',
  '@huanlin/dsh-plugin-codegraph-sqlite',
  '@huanlin/dsh-plugin-codegraph-tree-sitter',
  '@huanlin/dsh-plugin-codegraph-tool',
] as const

/** Mirrors the language-id rule in dsh's package-meta contract. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

const repoRoot = join(import.meta.dirname, '..', '..', '..')

function packageDir(dir: string): string {
  return join(repoRoot, 'packages', dir)
}

describe('Plugins page locale meta', () => {
  for (const dir of PACKAGE_DIRS) {
    it(`${dir}: ships parseable locale files with non-empty meta fields`, () => {
      const localeDir = join(packageDir(dir), 'locale')
      const languages = new Set<string>()
      for (const entry of readdirSync(localeDir, { withFileTypes: true })) {
        expect(entry.isFile(), `${entry.name} must be a regular file`).toBe(true)
        expect(entry.name.endsWith('.json'), `${entry.name} must end in .json`).toBe(true)
        const language = entry.name.slice(0, -5)
        expect(LANGUAGE_ID.test(language), `${entry.name} must be named by a language id`).toBe(true)
        const id = language.toLowerCase()
        expect(languages.has(id), `${entry.name} duplicates locale ${id}`).toBe(false)
        languages.add(id)

        const parsed: unknown = JSON.parse(readFileSync(join(localeDir, entry.name), 'utf8'))
        expect(parsed, `${entry.name} must contain an object`).toBeTypeOf('object')
        const meta = (parsed as { meta?: unknown }).meta
        expect(meta, `${entry.name}: meta must be an object`).toBeTypeOf('object')
        for (const field of ['title', 'description'] as const) {
          const value = (meta as Record<string, unknown>)[field]
          expect(
            typeof value === 'string' && value.trim() !== '',
            `${entry.name}: meta.${field} must be a non-empty string`,
          ).toBe(true)
        }
      }
      expect(languages.has('en'), 'locale/en.json is the anchor and must exist').toBe(true)
    })

    it(`${dir}: exports glob and files list admit the locale directory`, () => {
      const manifest: { exports?: Record<string, unknown>, files?: unknown } =
        JSON.parse(readFileSync(join(packageDir(dir), 'package.json'), 'utf8'))
      expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
      expect(manifest.exports?.['./package.json']).toBe('./package.json')
      expect(manifest.files).toContain('locale/')
    })
  }

  it('every cordis.patch.yml row package carries locale meta', () => {
    const patch = readFileSync(join(packageDir('bundle'), 'cordis.patch.yml'), 'utf8')
    const names = [...patch.matchAll(/name:\s*'([^']+)'/gu)].map(match => match[1] ?? '')
    expect(names).toEqual([...ROW_NAMES])
    const prefix = '@huanlin/dsh-plugin-codegraph-'
    for (const name of ROW_NAMES) {
      expect(PACKAGE_DIRS, `${name} must map to a wired package directory`).toContain(name.slice(prefix.length))
    }
  })
})
