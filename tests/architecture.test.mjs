import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { createPersistence } from '../src/bootstrap/persistence.ts'

const root = fileURLToPath(new URL('../src/', import.meta.url))
function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    return entry.isDirectory()
      ? files(path)
      : path.endsWith('.ts')
        ? [path]
        : []
  })
}
test('domain, application and HTTP cannot depend on concrete persistence', () => {
  for (const layer of ['domain', 'application', 'http']) {
    for (const file of files(resolve(root, layer))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      function visit(node) {
        let specifier
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          specifier = node.moduleSpecifier
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        )
          specifier = node.arguments[0]
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text
          const target = name.startsWith('.')
            ? relative(root, resolve(dirname(file), name))
            : name
          const forbidden = [
            'infrastructure/',
            'bootstrap/',
            'node:sqlite',
            '@google-cloud/',
            'google-',
          ]
          if (layer !== 'http')
            forbidden.push('http/', 'node:http', 'node:https')
          if (layer === 'domain') forbidden.push('application/')
          assert.ok(
            !forbidden.some((prefix) => target.startsWith(prefix)),
            `${relative(root, file)} imports ${name}`,
          )
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
})
test('composition selects only the injected provider and rejects unknown providers', async () => {
  const calls = []
  const runtime = { store: {}, auth: {} }
  const registry = {
    test: async (config) => {
      calls.push(config)
      return runtime
    },
    unused: async () => {
      throw new Error('Wrong provider selected')
    },
  }
  const config = { origin: 'http://localhost:5173' }
  assert.equal(await createPersistence('test', config, registry), runtime)
  assert.deepEqual(calls, [config])
  await assert.rejects(
    createPersistence('toString', config, registry),
    /DATA_BACKEND/,
  )
})

test('named types live in declaration modules, not implementations', () => {
  for (const file of files(root).filter((name) => !name.endsWith('.d.ts'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    function visit(node) {
      assert.ok(
        !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node),
        `Move types from ${relative(root, file)} into a .d.ts module`,
      )
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
})
