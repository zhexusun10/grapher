// Byte-budgeted Map with normal Map iteration and mutation semantics.
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4; i++;
    } else bytes += 3;
  }
  return bytes;
}

export class BoundedLruCache<K, V> extends Map<K, V> {
  private sizes = new Map<K, number>();
  private usedBytes = 0;
  constructor(
    private readonly sizeOf: (value: V) => number,
    readonly maxEntries = 20,
    readonly maxBytes = 30 * 1024 * 1024,
  ) {
    super();
  }
  get byteSize() { return this.usedBytes; }
  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }
  override set(key: K, value: V): this {
    this.delete(key);
    const bytes = this.sizeOf(value);
    // Oversized entries remain visible in the mounted component, but are not
    // retained globally after the user leaves it.
    if (bytes > this.maxBytes || this.maxEntries <= 0) return this;
    super.set(key, value);
    this.sizes.set(key, bytes);
    this.usedBytes += bytes;
    while (this.size > this.maxEntries || this.usedBytes > this.maxBytes) {
      this.delete(this.keys().next().value!);
    }
    return this;
  }
  override delete(key: K): boolean {
    this.usedBytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    return super.delete(key);
  }
  override clear(): void {
    super.clear();
    this.sizes.clear();
    this.usedBytes = 0;
  }
}
