import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://keltus.ru',
  trailingSlash: 'always',
  server: { port: 4321, host: true },
  build: { inlineStylesheets: 'always' },
  image: {
    domains: ['admin.keltus.ru'],
    remotePatterns: [{ protocol: 'https', hostname: 'admin.keltus.ru' }],
  },
  integrations: [
    sitemap({
      changefreq: 'weekly',
      priority: 0.7,
      lastmod: new Date(),
    }),
  ],
});
