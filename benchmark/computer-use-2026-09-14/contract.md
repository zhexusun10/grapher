# Catalog toolkit
Implement two independent, dependency-free Node.js modules and then verify their interoperability.
Existing public contract (do not redesign):
- src/csv.mjs exports parseCatalog(csvText), returning [{id: string, name: string, price: number}]. Header is id,name,price; handle quoted commas, escaped quotes, CRLF, empty input, and reject malformed rows and negative/non-finite prices.
- src/search.mjs exports searchCatalog(items, {query = '', minPrice = 0, maxPrice = Infinity} = {}). Case-insensitive substring search on name; inclusive price bounds; preserve order, do not mutate input; reject invalid bounds.
- No runtime dependencies, no network services, Node built-in tests only.
