import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { loadDocument, saveDocument } from '../utils/persistence';

export class YjsService {
  private docs = new Map<string, Y.Doc>();
  private awarenesses = new Map<string, Awareness>();

  getDoc(roomId: string): Y.Doc {
    if (this.docs.has(roomId)) {
      return this.docs.get(roomId)!;
    }

    console.log(`✨ Creating new doc for room: ${roomId}`);
    const doc = new Y.Doc();
    loadDocument(doc, roomId);

    let saveTimeout: NodeJS.Timeout;
    doc.on('update', (update, origin) => {
      if (origin !== 'load') {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => saveDocument(doc, roomId), 1000);
      }
    });

    this.docs.set(roomId, doc);
    return doc;
  }

  getAwareness(roomId: string): Awareness {
    if (this.awarenesses.has(roomId)) {
      return this.awarenesses.get(roomId)!;
    }
    
    const doc = this.getDoc(roomId);
    const awareness = new Awareness(doc);
    this.awarenesses.set(roomId, awareness);
    return awareness;
  }

  getAllDocs(): Map<string, Y.Doc> {
    return this.docs;
  }

  saveAll(): void {
    console.log(`🔄 Saving all docs: ${this.docs.size} total`);
    for (const [roomId, doc] of this.docs.entries()) {
      saveDocument(doc, roomId);
    }
  }
}

export const yjsService = new YjsService();