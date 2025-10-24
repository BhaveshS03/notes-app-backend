import { Response } from "express";
import { Document } from "../models/Document";
import { User } from "../models/User";
import { AuthRequest } from "../middleware/auth";
import { yjsService } from "../services/yjs.service";
import { deleteDocumentFiles } from "../utils/persistence";

export const createDocument = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const doc = new Document({
      title: req.body.title || "Untitled Document",
      owner: user._id,
    });

    await doc.save();

    user.documents.push(doc._id.toString());
    await user.save();

    res.json({
      ok: true,
      roomId: doc._id.toString(),
      meta: {
        id: user._id,
        title: doc.title,
        createdAt: doc.createdAt,
        lastModified: doc.lastModified,
        owner: user._id,
        starred: doc.starred,
        sharedWith: req.body.sharedWith || [],
      },
    });
  } catch (err) {
    console.error("Error creating document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

// export const starDoc = async (req: AuthRequest, res: Response) => {
//   const { roomId } = req.params;
//   const doc = await Document.findById(roomId);
//   if (!doc) {
//     return res.status(404).json({ ok: false, error: "Document not found" });
//   }

// };

export const updateDocument = async (req: AuthRequest, res: Response) => {
  const { title, starred } = req.body;
  const { roomId } = req.params;

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const doc = await Document.findById(roomId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }

    if (title) doc.title = title;
    if (typeof starred === "boolean") doc.starred = starred;
    doc.lastModified = new Date();
    await doc.save();

    res.json({
      ok: true,
      roomId: doc._id.toString(),
      meta: {
        id: user._id,
        title: doc.title,
        createdAt: doc.createdAt,
        lastModified: doc.lastModified,
        owner: doc.owner,
        starred: doc.starred,
        sharedWith: doc.sharedWith,
      },
    });
  } catch (err) {
    console.error("Error updating document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

export const shareDocument = async (req: AuthRequest, res: Response) => {
  const { docId, emailId } = req.body;

  try {
    const currentUser = await User.findById(req.userId);
    if (!currentUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const doc = await Document.findById(docId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }

    const userToShare = await User.findOne({ email: emailId });
    if (!userToShare) {
      return res
        .status(404)
        .json({ ok: false, error: "User to share with not found" });
    }

    if (!doc.sharedWith.includes(userToShare._id)) {
      doc.sharedWith.push(userToShare._id);
      await doc.save();
    }

    res.json({ ok: true, sharedWith: doc.sharedWith });
  } catch (err) {
    console.error("Error sharing document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

export const deleteDocument = async (req: AuthRequest, res: Response) => {
  const { docId } = req.body;

  try {
    const currentUser = await User.findById(req.userId);
    if (!currentUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const doc = await Document.findById(docId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }

    // Owner deletes the document
    if (doc.owner.toString() === currentUser._id.toString()) {
      await doc.deleteOne();
      currentUser.documents = currentUser.documents.filter(
        (d) => d.toString() !== doc._id.toString(),
      );
      await currentUser.save();

      deleteDocumentFiles(doc._id.toString());

      return res.json({ ok: true, message: "Document deleted successfully" });
    }

    // Shared user removes themselves
    if (doc.sharedWith.some((id) => id.equals(currentUser._id))) {
      doc.sharedWith = doc.sharedWith.filter(
        (id) => !id.equals(currentUser._id),
      );
      await doc.save();
      return res.json({ ok: true, message: "Removed from shared list" });
    }

    return res.status(403).json({ ok: false, error: "Not authorized" });
  } catch (err) {
    console.error("Error deleting document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

export const getMyDocuments = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const docs = await Document.find({
      $or: [{ owner: user._id }, { sharedWith: user._id }],
    }).sort({ lastModified: -1 });

    res.json({
      ok: true,
      documents: docs.map((d) => ({
        id: d._id,
        title: d.title,
        owner: d.owner,
        sharedWith: d.sharedWith,
        starred: d.starred,
        createdAt: d.createdAt,
        lastModified: d.lastModified,
      })),
    });
  } catch (err) {
    console.error("Error fetching documents:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

export const getActiveDocs = (req: AuthRequest, res: Response) => {
  const rooms = Array.from(yjsService.getAllDocs().entries()).map(
    ([roomId, doc]) => {
      const meta = doc.getMap("meta");
      return {
        roomId,
        meta: {
          title: meta.get("title") || "Untitled",
          owner: meta.get("owner") || null,
          createdAt: meta.get("createdAt") || null,
          lastModified: meta.get("lastModified") || null,
          currentUser: meta.get("current_user") || null,
          starred: meta.get("starred") || false,
        },
      };
    },
  );

  res.json({ rooms });
};
