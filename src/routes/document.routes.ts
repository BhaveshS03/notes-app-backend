import { Router } from 'express';
import * as documentController from '../controllers/document.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/create-doc', authenticate, documentController.createDocument);
router.put('/update-doc/:roomId', authenticate, documentController.updateDocument);
router.post('/share-doc', authenticate, documentController.shareDocument);
router.post('/delete-doc', authenticate, documentController.deleteDocument);
router.get('/my-docs', authenticate, documentController.getMyDocuments);
router.get('/active-docs', authenticate, documentController.getActiveDocs);

export default router;