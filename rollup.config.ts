import * as fs from 'node:fs'
import { babel } from '@rollup/plugin-babel'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

interface PackageJson {
  dependencies?: Record<string, string>
}

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8')) as PackageJson
const nodeBuiltins = [
  'fs/promises',
  'node:child_process',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
  'node:readline',
  'node:readline/promises',
  'node:url',
]
const external = Object.keys(pkg.dependencies ?? {}).concat(nodeBuiltins)

const extensions = ['.js', '.ts']

/** @type {import('rollup').RollupOptions} */
const config = {
  input: 'src/main.ts',
  output: [
    {
      file: './bin/cli.cjs',
      format: 'cjs',
      banner: '#!/usr/bin/env node',
    },
    {
      file: './bin/cli.mjs',
      format: 'esm',
      banner: '#!/usr/bin/env node',
    },
  ],
  external,
  plugins: [
    nodeResolve({
      extensions,
      modulesOnly: true,
    }),
    json(),
    typescript({
      tsconfig: './tsconfig.json',
      noForceEmit: true,
      compilerOptions: {
        noEmit: true,
      },
      declaration: false,
      declarationMap: false,
    }),
    babel({
      babelHelpers: 'bundled',
      babelrc: false,
      extensions,
      exclude: 'node_modules/**',
      presets: [
        ['@babel/preset-env', { modules: false, targets: { node: '20' } }],
        '@babel/preset-typescript',
      ],
    }),
  ],
}

export default config
