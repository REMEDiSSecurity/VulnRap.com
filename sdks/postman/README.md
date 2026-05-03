# VulnRap Postman Collection

A Postman v2.1 collection covering every public endpoint of the VulnRap API,
auto-generated from `lib/api-spec/openapi.yaml`.

## Files

- `vulnrap.postman_collection.json` — the collection itself. Importable into
  Postman, Insomnia (Postman v2.1 import), Bruno, Hoppscotch, and most other
  HTTP clients that speak the format.

## Import

1. Download `vulnrap.postman_collection.json`
   ([from vulnrap.com](https://vulnrap.com/vulnrap.postman_collection.json) or
   from this folder).
2. In Postman, click **Import** → drop the file in.
3. The collection ships with a single variable, `baseUrl`, defaulting to
   `https://vulnrap.com/api`. Override it on the collection (or in an
   environment) to point at a self-hosted instance.

## Regenerate

The collection is checked in so the `/developers` page can serve a stable
download link without users running anything. To regenerate after editing the
OpenAPI spec:

```bash
pnpm --filter @workspace/scripts run generate:postman
# or
node scripts/generate-postman.mjs
```

The generator (`scripts/generate-postman.mjs`) reads
`lib/api-spec/openapi.yaml`, runs it through
[`openapi-to-postmanv2`](https://www.npmjs.com/package/openapi-to-postmanv2),
folds requests into folders by tag, swaps the server host for a
`{{baseUrl}}` variable, and writes the result to:

- `sdks/postman/vulnrap.postman_collection.json` (canonical, checked in)
- `artifacts/vulnrap/public/vulnrap.postman_collection.json` (mirrored so the
  `/developers` download button serves it from the same origin)

Both copies are updated in lockstep — re-run the generator whenever
`openapi.yaml` changes and commit both files.

## Insomnia, Bruno, Hoppscotch

Insomnia imports Postman v2.1 collections directly; no separate export is
maintained. Bruno and Hoppscotch likewise accept Postman v2.1 imports.
