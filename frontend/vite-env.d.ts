/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_ADMIN_KEY: string;
    // add more if needed
  }
  
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
  