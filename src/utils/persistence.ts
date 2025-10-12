import fs from 'fs';
import * as Y from 'yjs';
import { getFilePaths } from './helpers';
import { PERSISTENCE_DIR } from '../config/constants';

export const getMetaObject = (doc: Y.Doc): Record<string, any> => {
  const metaMap = doc.getMap('meta');
  const metaObj: any = {};
  metaMap.forEach((v, k) => { metaObj[k] = v; });
  return metaObj;
};

export const saveDocument = (doc: Y.Doc, roomId: string): boolean => {
  try {
    const { snapshot, markdown, meta } = getFilePaths(roomId, PERSISTENCE_DIR);

    // Save snapshot
    const snapshotData = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(snapshot, snapshotData);

    // Extract text
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, snapshotData);
    const ytext = tempDoc.getText('content');
    fs.writeFileSync(markdown, ytext.toString(), 'utf8');

    // Save meta
    const metaObj = getMetaObject(doc);
    fs.writeFileSync(meta, JSON.stringify(metaObj, null, 2), 'utf8');

    console.log(`💾 Saved room ${roomId}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to save room ${roomId}:`, err);
    return false;
  }
};

export const loadDocument = (doc: Y.Doc, roomId: string): void => {
  const { snapshot, markdown, meta } = getFilePaths(roomId, PERSISTENCE_DIR);

  // Load snapshot
  if (fs.existsSync(snapshot)) {
    try {
      const snapshotData = fs.readFileSync(snapshot);
      if (snapshotData.length > 0) {
        Y.applyUpdate(doc, snapshotData, 'load');
        console.log(`✅ Loaded snapshot for ${roomId}`);
      }
    } catch (err) {
      console.error(`❌ Failed to load snapshot for ${roomId}:`, err);
    }
  }

  // Load text fallback
  if (fs.existsSync(markdown)) {
    try {
      const content = fs.readFileSync(markdown, 'utf8');
      if (content.length > 0) {
        doc.getText('content').insert(0, content);
        console.log(`✅ Loaded markdown for ${roomId}`);
      }
    } catch (err) {
      console.error(`❌ Failed to load markdown for ${roomId}:`, err);
    }
  }

  // Load meta
  if (fs.existsSync(meta)) {
    try {
      const metaObj = JSON.parse(fs.readFileSync(meta, 'utf8') || '{}');
      const metaMap = doc.getMap('meta');
      for (const k in metaObj) metaMap.set(k, metaObj[k]);
      console.log(`🗂️ Loaded meta for ${roomId}`);
    } catch (err) {
      console.error(`❌ Failed to load meta for ${roomId}:`, err);
    }
  }
};

export const deleteDocumentFiles = (roomId: string): void => {
  const filePaths = [
    `${PERSISTENCE_DIR}/${roomId}-snapshot.bin`,
    `${PERSISTENCE_DIR}/${roomId}-markdown.txt`,
    `${PERSISTENCE_DIR}/${roomId}-meta.json`
  ];

  filePaths.forEach((file) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
};