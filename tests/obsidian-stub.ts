/** Stub mínimo del API de Obsidian para las pruebas fuera de la app. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');
}
export class TAbstractFile {
  path = '';
  name = '';
  parent: any = null;
  vault: any = null;
}
export type EventRef = unknown;
export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
  stat: any = { mtime: 0, size: 0, ctime: 0 };
}
export class TFolder extends TAbstractFile {
  children: any[] = [];
  isRoot(): boolean { return this.path === '/'; }
}
export class Vault {
  getAbstractFileByPath(): any { return null; }
  createBinary(): Promise<any> { return Promise.resolve(null); }
  modifyBinary(): Promise<void> { return Promise.resolve(); }
}
export class App {}
export class Plugin {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {
  setName(_name: any): this { return this; }
  setDesc(_desc: any): this { return this; }
  setHeading(): this { return this; }
  addButton(_cb: any): this { return this; }
  addToggle(_cb: any): this { return this; }
  addText(_cb: any): this { return this; }
  addDropdown(_cb: any): this { return this; }
}
export class Notice {}
export class MarkdownView {}
export class Component {}
export class ItemView {}
export class TextComponent {}
export class ButtonComponent {}
export class ToggleComponent {}
export class DropdownComponent {}
export function addIcon(): void {}
export function setIcon(): void {}
export function normalize(): void {}
