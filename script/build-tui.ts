#!/usr/bin/env bun

import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin'

const outfile = 'dist/src/tui.js'
const result = await Bun.build({
  entrypoints: ['src/tui.tsx'],
  outdir: 'dist/src',
  naming: '[name].[ext]',
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'external',
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const output = await Bun.file(outfile).text()
const reactiveActivity = /_\$insert\([^,]+, \(\) => showActivity\(\)/.test(output)
const reactiveDuration = /_\$insert\([^,]+, duration\)/.test(output)
if (
  output.includes('@opentui/solid/jsx-runtime') ||
  !output.includes('from "@opentui/solid"') ||
  !output.includes('from "solid-js"') ||
  !reactiveActivity ||
  !reactiveDuration
) {
  throw new Error(`${outfile} was not compiled with the OpenTUI Solid universal transform`)
}
