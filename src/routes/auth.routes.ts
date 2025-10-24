// routes/auth.ts
import { Request, Response, Router } from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/constants";
import { register, login, getProfile } from "../controllers/auth.controller";
import { authenticate } from "../middleware/auth";

const router = Router();

// Helper to create JWT tokens
const generateToken = (user: any) =>
  jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "12h" });

// --- Auth routes ---
router.post("/register", register);
router.post("/login", login);
router.get("/profile", authenticate, getProfile);

// --- Google OAuth: Step 1 ---
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

// --- Google OAuth: Step 2 (callback) ---
router.get(
  "/google/login",
  passport.authenticate("google", {
    failureRedirect: process.env.FRONTEND_URL + "/login?error=auth_failed",
    session: false, // using JWT, not sessions
  }),
  (req: Request, res: Response) => {
    const user = req.user as any;
    const token = generateToken(user);

    // Redirect user to frontend with token and basic info
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${token}&user=${encodeURIComponent(
      JSON.stringify({
        id: user._id,
        email: user.email,
        name: user.name,
      }),
    )}`;

    res.redirect(redirectUrl);
  },
);

// --- JSON-based Google OAuth (for mobile/API) ---
router.post(
  "/google",
  passport.authenticate("google", { session: false }),
  (req: Request, res: Response) => {
    const user = req.user as any;
    const token = generateToken(user);
    res.json({
      ok: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
      },
    });
  },
);

// --- Check auth status ---
router.get("/status", authenticate, (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({
    ok: true,
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
    },
  });
});

// --- Logout (client removes token) ---
router.post("/logout", (_req: Request, res: Response) => {
  res.json({ ok: true, message: "Logged out successfully" });
});

export default router;
