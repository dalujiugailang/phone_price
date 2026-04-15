/// <reference types="vite/client" />

declare module '*.xlsx?url' {
  const src: string;
  export default src;
}

declare global {
  interface Window {
    __PRELOADED_WORKBOOK_DATA__?: import('./data').WorkbookDataset;
  }
}

export {};
