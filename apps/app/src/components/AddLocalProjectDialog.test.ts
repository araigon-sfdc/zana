import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('AddLocalProjectDialog', () => {
  it('uses the portaled modal primitive so board headers cannot cover its backdrop', () => {
    const source = readFileSync(new URL('./AddLocalProjectDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import { Modal } from './Modal.js'");
    expect(source).toContain('<Modal');
    expect(source).not.toContain('className="modal-backdrop"');
  });

  it("formats the folder-path placeholder for the selected machine's OS", () => {
    const source = readFileSync(new URL('./AddLocalProjectDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('placeholder={folderPathPlaceholder(selectedHost)}');
    expect(source).not.toContain('placeholder="/path/to/project"');
  });
});
