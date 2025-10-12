import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import passport from 'passport';

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/profile', authenticate, authController.getProfile);
router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));
router.get(
    "/google/login",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => res.redirect("/editor")
);

export default router;