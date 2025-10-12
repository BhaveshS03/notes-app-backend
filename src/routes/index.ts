import { Router } from 'express';
import authRoutes from './auth.routes';
import documentRoutes from './document.routes';

const router = Router();

router.use('/api', authRoutes);
router.use('/api', documentRoutes);

export default router;