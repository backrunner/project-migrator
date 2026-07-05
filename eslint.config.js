import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  typescript: {
    tsconfigPath: 'tsconfig.json',
  },
  formatters: {
    markdown: 'prettier',
  },
  ignores: [
    'node_modules/',
    'bin/',
    '.history/',
    'rollup.config.js',
    'src/**/*.js',
    '**/*.min.js',
    '**/*-min.js',
    '**/*.bundle.js',
  ],
  isInEditor: true,
})
