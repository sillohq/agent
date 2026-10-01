# Inertia front end

## Packages

```bash
npm install @inertiajs/vue3 vue            # or: @inertiajs/react react react-dom
npm install -D vite @vitejs/plugin-vue      # or: @vitejs/plugin-react
```

## Vue entry (`js/main.ts`)

```ts
import { createApp, h } from 'vue'
import { createInertiaApp } from '@inertiajs/vue3'

createInertiaApp({
  id: 'app',                                   // = root_id on the adapter and the root element id
  resolve: (name) => {
    const pages = import.meta.glob('../views/pages/**/*.vue', { eager: true })
    return pages[`../views/pages/${name}.vue`]
  },
  setup({ el, App, props, plugin }) {
    createApp({ render: () => h(App, props) }).use(plugin).mount(el)
  },
})
```

React is the same shape with `@inertiajs/react`, `createRoot(el).render(<App {...props} />)`
and `import.meta.glob('./pages/**/*.jsx', { eager: true })`.

## `vite.config.ts`

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'static/build',
    manifest: true,                  // written to static/build/.vite/manifest.json
    rollupOptions: { input: 'js/main.ts' },
  },
})
```

The `entry` given to `vite_vue(...)`/`vite_react(...)` must equal
`build.rollupOptions.input`, and `manifest_path` must point at the manifest Vite writes
(`<outDir>/.vite/manifest.json` since Vite 5). If they drift, development works and
production renders a page with no script.

## Development and production

- Development: `npm run dev` (Vite on :5173) and `sillo dev`; `vite_vue(dev=True)`.
- Production: `npm run build`, serve `static/build` (the proxy, or a `Group` +
  `StaticFiles` mount at the asset prefix), `dev=False`, and bump the adapter `version`
  (e.g. from the manifest hash) so open tabs reload.

## Forms (Vue)

```vue
<script setup lang="ts">
import { useForm } from '@inertiajs/vue3'
const form = useForm({ email: '', password: '' })
</script>

<template>
  <form @submit.prevent="form.post('/login')">
    <input v-model="form.email" />
    <p v-if="form.errors.email">{{ form.errors.email }}</p>
    <button :disabled="form.processing">Sign in</button>
  </form>
</template>
```

`form.errors` is filled from the `errors` prop that `set_errors(ctx, {...})` stored before
`back()`.

## Props are public

Everything in props is serialised into the page and visible to the user. `Decimal`,
dates, UUIDs and enums are encoded by the adapter; models are not filtered — build plain
dicts with the fields the page needs.
