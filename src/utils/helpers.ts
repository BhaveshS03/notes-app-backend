export const cleanRoomId = (url: string): string => {
  console.log('Raw room ID from URL:', url);
  if (!url || url === '/') return 'default';
  
  let roomId = url.startsWith('/') ? url.slice(1) : url;
  if (roomId.startsWith('?room=')) {
    roomId = roomId.replace('?room=', '');
  }
  
  return roomId.replace(/[/\\:*?"<>|]/g, '_') || 'default';
};

export const getFilePaths = (roomId: string, persistenceDir: string) => ({
  snapshot: `${persistenceDir}/${roomId}-snapshot.bin`,
  markdown: `${persistenceDir}/${roomId}-markdown.txt`,
  meta: `${persistenceDir}/${roomId}-meta.json`
});

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback",
      },
      (accessToken, refreshToken, profile, done) => {
        return done(null, profile);
      }
    )
  );
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));