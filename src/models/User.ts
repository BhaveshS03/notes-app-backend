import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface IUser extends MongoDocument {
  email: string;
  name: string;
  password: string;
  createdAt: Date;
  deletedAt?: Date;
  documents: string[];
  googleId?: string;
}

const userSchema = new Schema<IUser>({
  email: { type: String, unique: true, required: true, trim: true },
  name: { type: String, required: true },
  password: { type: String },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date },
  documents: [{ type: String }],
  googleId: {
    type: String,
    index: true, 
    sparse: true,
  },
});

// userSchema.index({ googleId: 1 }, { sparse: true });
export const User = mongoose.model<IUser>("User", userSchema);
