import mongoose, { Schema, Document as MongoDocument } from 'mongoose';

export interface IUser extends MongoDocument {
  email: string;
  name: string;
  password: string;
  createdAt: Date;
  deletedAt?: Date;
  documents: string[];
}

const userSchema = new Schema<IUser>({
  email: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date },
  documents: [{ type: String }]
});

export const User = mongoose.model<IUser>('User', userSchema);