import mongoose, { Schema, Document as MongoDocument } from 'mongoose';

export interface IDocument extends MongoDocument {
  title: string;
  owner: mongoose.Types.ObjectId;
  createdAt: Date;
  lastModified: Date;
  starred: boolean;
  sharedWith: mongoose.Types.ObjectId[];
}

const documentSchema = new Schema<IDocument>({
  title: { type: String, default: 'Untitled Document' },
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  lastModified: { type: Date, default: Date.now },
  starred: { type: Boolean, default: false },
  sharedWith: [{ type: Schema.Types.ObjectId, ref: 'User' }]
});

export const Document = mongoose.model<IDocument>('Document', documentSchema);