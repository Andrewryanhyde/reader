import { LibraryEntry, LibraryListItem, SavedChunk, deriveTitle } from "./library";
import { TtsVoice } from "./tts";

const DATABASE_NAME = "reader-library";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";

type SaveEntryInput = {
  text: string;
  voice: TtsVoice;
  chunks: SavedChunk[];
  durationSeconds?: number;
};

function ensureIndexedDb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("This browser does not support IndexedDB.");
  }

  return indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
  const idb = ensureIndexedDb();

  return new Promise((resolve, reject) => {
    const request = idb.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

function closeDatabase(database: IDBDatabase) {
  database.close();
}

export async function listEntries(): Promise<LibraryListItem[]> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const entries = (request.result as LibraryEntry[]).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );

      resolve(
        entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          voice: entry.voice,
          createdAt: entry.createdAt,
          charCount: entry.text.length,
          durationSeconds: entry.durationSeconds,
        })),
      );
    };

    request.onerror = () => reject(request.error ?? new Error("Failed to list saved entries."));
    transaction.oncomplete = () => closeDatabase(database);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Failed to list saved entries."));
  });
}

export async function getEntry(id: string): Promise<LibraryEntry | null> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => resolve((request.result as LibraryEntry | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Failed to load saved entry."));
    transaction.oncomplete = () => closeDatabase(database);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Failed to load saved entry."));
  });
}

export async function saveEntry(input: SaveEntryInput): Promise<LibraryEntry> {
  const database = await openDatabase();
  const entry: LibraryEntry = {
    id: crypto.randomUUID(),
    title: deriveTitle(input.text),
    text: input.text,
    voice: input.voice,
    createdAt: new Date().toISOString(),
    chunks: input.chunks,
    durationSeconds: input.durationSeconds,
  };

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(entry);

    request.onsuccess = () => resolve(entry);
    request.onerror = () => reject(request.error ?? new Error("Failed to save entry."));
    transaction.oncomplete = () => closeDatabase(database);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Failed to save entry."));
  });
}

export async function updateEntryDuration(id: string, durationSeconds: number): Promise<void> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as LibraryEntry | undefined;
      if (!entry) return resolve();
      entry.durationSeconds = durationSeconds;
      store.put(entry);
    };

    getRequest.onerror = () => reject(getRequest.error ?? new Error("Failed to update entry."));
    transaction.oncomplete = () => { closeDatabase(database); resolve(); };
    transaction.onabort = () => reject(transaction.error ?? new Error("Failed to update entry."));
  });
}

export async function updateEntryProgress(id: string, progressSeconds: number): Promise<void> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as LibraryEntry | undefined;
      if (!entry) return resolve();
      entry.progressSeconds = progressSeconds;
      store.put(entry);
    };

    getRequest.onerror = () => reject(getRequest.error ?? new Error("Failed to update progress."));
    transaction.oncomplete = () => { closeDatabase(database); resolve(); };
    transaction.onabort = () => reject(transaction.error ?? new Error("Failed to update progress."));
  });
}

export async function deleteEntry(id: string): Promise<void> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to delete entry."));
    transaction.oncomplete = () => closeDatabase(database);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Failed to delete entry."));
  });
}
