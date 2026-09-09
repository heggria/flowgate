export class DraftStore {
  private rejected = new Set<string>();
  assertReloadable() {
    if (this.rejected.size)
      throw new Error("有草稿尚未保存，请缩减输入后重试，再更新或重载界面");
  }
  private values = new Map<string, unknown>();
  get(key = "subscription") {
    this.validate(key);
    return this.values.get(key) ?? null;
  }
  set(key: string, value: unknown) {
    this.validate(key);
    const next = new Map(this.values);
    if (value === null) next.delete(key);
    else next.set(key, value);
    if (JSON.stringify([...next]).length > 4 * 1024 * 1024) {
      this.rejected.add(key);
      throw new Error("草稿超过大小限制");
    }
    this.rejected.delete(key);
    this.values = next;
  }
  private validate(key: string) {
    if (!/^[a-z][\w.-]{0,63}$/.test(key)) throw new Error("无效草稿标识");
  }
}
