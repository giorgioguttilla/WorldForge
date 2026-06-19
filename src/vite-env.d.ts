/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean;
}
