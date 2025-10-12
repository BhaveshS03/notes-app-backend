import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { JWT_SECRET } from '../config/constants';
import { AuthRequest } from '../middleware/auth';

export const register = async (req: Request, res: Response) => {
  const { fullName: name, email, password } = req.body;
  
  if (!email || !name || !password) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ ok: false, error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ email, name, password: hashedPassword });
    await newUser.save();

    const token = jwt.sign({ id: newUser._id }, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      ok: true,
      token,
      user: { id: newUser._id, email: newUser.email, name: newUser.name }
    });
  } catch (err) {
    console.error('Error during registration:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (!existingUser) {
      return res.status(400).json({ ok: false, error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, existingUser.password);
    if (!isPasswordValid) {
      return res.status(400).json({ ok: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: existingUser._id }, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      ok: true,
      token,
      user: { id: existingUser._id, email: existingUser.email, name: existingUser.name }
    });
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

export const getProfile = async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    res.json({
      ok: true,
      user: { id: user._id, email: user.email, name: user.name }
    });
  } catch (err) {
    console.error('Error fetching profile:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};