import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: ['es2015', 'chrome64', 'ios11']
  }
});
