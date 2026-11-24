import { contextBridge, ipcRenderer } from 'electron';

// The window gets exactly one function. It cannot reach Node, the file system or the database.
contextBridge.exposeInMainWorld('api', {
  invoke: (method: string, args: unknown[]): Promise<unknown> => ipcRenderer.invoke('api:invoke', method, args),
});
