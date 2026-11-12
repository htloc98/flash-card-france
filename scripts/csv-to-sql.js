import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { lessonEntries } from '../src/server/lesson.js'
import { seedStatements } from '../src/server/database.js'

export function statementsToSql(statements) {
  return statements.map(({ sql, params }) => {
    let index = 0
    const expanded = sql.replace(/\?/g, () => {
      if (index >= params.length) throw new Error('Missing SQL parameter')
      const value = params[index++]
      if (value === null) return 'NULL'
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid SQL parameter')
      return `'${value.replaceAll("'", "''")}'`
    })
    if (index !== params.length) throw new Error('Unexpected SQL parameters')
    return `${expanded};`
  }).join('\n') + '\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { owner: { type: 'string' }, output: { type: 'string' } } })
    if (!values.owner || !/^[a-zA-Z0-9_-]{1,100}$/.test(values.owner) || !values.output) {
      throw new Error('Usage: npm run db:seed:sql -- --owner USER_ID --output data/lesson-1.sql')
    }
    const entries = await lessonEntries()
    await writeFile(resolve(values.output), statementsToSql(seedStatements(values.owner, entries)), { encoding: 'utf8', flag: 'wx' })
    console.log(`Generated ${entries.length} vocabulary rows for owner ${values.owner}. The account must already exist in D1.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}