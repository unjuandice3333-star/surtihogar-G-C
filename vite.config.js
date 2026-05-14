import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: ['es2015', 'chrome64', 'ios11']
  }
});
