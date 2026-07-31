import { createConfig } from './eslint.shared'

export default [
  ...createConfig(import.meta.url),
  {
    files: ['**/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly'
      }
    }
  }
]
