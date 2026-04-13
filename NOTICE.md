# Third-Party Notices and Acknowledgments

VulnRap is built on the shoulders of excellent open-source projects. We are grateful to the maintainers and contributors of every library listed here.

This file covers all direct runtime and development dependencies declared across the monorepo workspace packages.

---

## Runtime Dependencies

### Backend (Express / Node.js)

| Package | License | Description |
|---------|---------|-------------|
| [Express](https://expressjs.com/) | MIT | Fast, unopinionated web framework for Node.js |
| [Drizzle ORM](https://orm.drizzle.team/) | Apache-2.0 | TypeScript ORM for SQL databases |
| [drizzle-zod](https://orm.drizzle.team/) | Apache-2.0 | Zod schema generation from Drizzle tables |
| [OpenAI Node SDK](https://github.com/openai/openai-node) | Apache-2.0 | Official OpenAI API client for Node.js |
| [Pino](https://getpino.io/) | MIT | Super fast, all natural JSON logger |
| [pino-http](https://github.com/pinojs/pino-http) | MIT | High-speed HTTP logger for Node.js |
| [pino-pretty](https://github.com/pinojs/pino-pretty) | MIT | Prettifier for Pino log lines |
| [Helmet](https://helmetjs.github.io/) | MIT | Security middleware for Express |
| [CORS](https://github.com/expressjs/cors) | MIT | Cross-Origin Resource Sharing middleware |
| [compression](https://github.com/expressjs/compression) | MIT | Node.js compression middleware |
| [cookie-parser](https://github.com/expressjs/cookie-parser) | MIT | Cookie parsing middleware |
| [Multer](https://github.com/expressjs/multer) | MIT | Multipart form data handling |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | MIT | Rate limiting middleware for Express |
| [pdf-parse-new](https://github.com/niceDev0908/pdf-parse-new) | MIT | Pure JavaScript PDF parser |
| [Swagger UI Express](https://github.com/scottie1984/swagger-ui-express) | MIT | Auto-generate Swagger UI for Express |
| [yamljs](https://github.com/jeremyfa/yaml.js) | MIT | YAML parser and serializer |
| [Zod](https://zod.dev/) | MIT | TypeScript-first schema validation |
| [pg](https://node-postgres.com/) | MIT | PostgreSQL client for Node.js |

### Frontend (React / Vite)

| Package | License | Description |
|---------|---------|-------------|
| [React](https://react.dev/) | MIT | UI library for building user interfaces |
| [React DOM](https://react.dev/) | MIT | React package for working with the DOM |
| [React Router](https://reactrouter.com/) | MIT | Declarative routing for React |
| [Vite](https://vite.dev/) | MIT | Next-generation frontend build tool |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT | Vite plugin for React Fast Refresh |
| [TailwindCSS](https://tailwindcss.com/) | MIT | Utility-first CSS framework |
| [@tailwindcss/vite](https://tailwindcss.com/) | MIT | TailwindCSS Vite integration |
| [@radix-ui/react-label](https://www.radix-ui.com/) | MIT | Accessible label primitive |
| [@radix-ui/react-progress](https://www.radix-ui.com/) | MIT | Accessible progress bar primitive |
| [@radix-ui/react-radio-group](https://www.radix-ui.com/) | MIT | Accessible radio group primitive |
| [@radix-ui/react-separator](https://www.radix-ui.com/) | MIT | Accessible separator primitive |
| [@radix-ui/react-slot](https://www.radix-ui.com/) | MIT | Slot composition primitive |
| [@radix-ui/react-toast](https://www.radix-ui.com/) | MIT | Accessible toast notification primitive |
| [@radix-ui/react-tooltip](https://www.radix-ui.com/) | MIT | Accessible tooltip primitive |
| [Lucide React](https://lucide.dev/) | ISC | Beautiful & consistent icon toolkit |
| [Framer Motion](https://www.framer.com/motion/) | MIT | Production-ready motion library for React |
| [TanStack Query](https://tanstack.com/query) | MIT | Powerful async state management for React |
| [class-variance-authority](https://cva.style/) | Apache-2.0 | CSS class composition utility |
| [clsx](https://github.com/lukeed/clsx) | MIT | Tiny utility for constructing className strings |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) | MIT | Merge TailwindCSS classes without conflicts |
| [tw-animate-css](https://github.com/niceDev0908/tw-animate-css) | MIT | Tailwind CSS animation utilities |

### Code Generation & Tooling

| Package | License | Description |
|---------|---------|-------------|
| [Orval](https://orval.dev/) | MIT | OpenAPI client code generator |
| [Drizzle Kit](https://orm.drizzle.team/) | Apache-2.0 | CLI toolkit for Drizzle ORM migrations |
| [esbuild](https://esbuild.github.io/) | MIT | Extremely fast JavaScript bundler |
| [esbuild-plugin-pino](https://github.com/niceDev0908/esbuild-plugin-pino) | MIT | Pino compatibility plugin for esbuild |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | Typed superset of JavaScript |
| [thread-stream](https://github.com/pinojs/thread-stream) | MIT | Worker thread stream for Pino |

---

## Algorithms and Techniques

VulnRap's similarity detection is built on well-established academic work:

- **MinHash** — Broder, A. Z. (1997). "On the Resemblance and Containment of Documents." *Compression and Complexity of Sequences.*
- **SimHash** — Charikar, M. S. (2002). "Similarity Estimation Techniques from Rounding Algorithms." *STOC '02.*
- **Locality-Sensitive Hashing (LSH)** — Indyk, P., & Motwani, R. (1998). "Approximate Nearest Neighbors: Towards Removing the Curse of Dimensionality." *STOC '98.*
- **Noisy-OR probability combination** — Pearl, J. (1988). *Probabilistic Reasoning in Intelligent Systems.* Used for multi-axis score fusion.

## Community References

This project was motivated by the ongoing AI slop crisis documented by:

- **Daniel Stenberg / curl** — [Blog posts on AI slop reports](https://daniel.haxx.se/) and the eventual shutdown of the curl bug bounty program (January 2026)
- **Apache Log4j team** — Documentation of 60+ AI slop examples in their YesWeHack program
- **Node.js security team** — Reports of 30+ AI slop submissions during a single holiday period
- **OpenSSF Vulnerability Disclosures Working Group** — GitHub issues [#178](https://github.com/ossf/wg-vulnerability-disclosures/issues/178) and [#179](https://github.com/ossf/wg-vulnerability-disclosures/issues/179) discussing the community response

---

## License

VulnRap itself is released under the terms specified in the project's LICENSE file.

All third-party packages retain their original licenses. No modifications have been made to any third-party source code; all packages are used as distributed via npm.
