/* =====================================================================
   RÉGLAGES DU SITE — le seul fichier à modifier.
   Ouvrez-le avec le Bloc-notes, complétez les 3 lignes ci-dessous,
   enregistrez, puis remettez le site en ligne (voir le guide).
   ===================================================================== */
window.SITE_CONFIG = {
  // 1) Adresse du projet Supabase  (Supabase > Project Settings > API > Project URL)
  supabaseUrl: "",

  // 2) Clé publique « anon public »  (même page, rubrique Project API keys)
  supabaseAnonKey: "",

  // 3) Votre adresse e-mail de connexion (la même que dans le fichier SQL)
  ownerEmail: "",

  /* ---- Rien à modifier en dessous ---- */
  // Documents affichés tant qu'aucun document n'a été déposé depuis l'espace privé
  defaultDocuments: [
  {
    "id": "rapport",
    "title": "Rapport de fin de formation",
    "category": "Rapport",
    "description": "Analyse du système de gestion du courrier administratif dans une collectivité locale : cas de la Mairie de Doumassessé (Commune du Golfe 3).",
    "url": "docs/Rapport_TCHAKONDO_Aicha.pdf",
    "file_name": "Rapport_TCHAKONDO_Aicha.pdf",
    "mime": "application/pdf",
    "size_bytes": 1763776
  },
  {
    "id": "presentation",
    "title": "Présentation de soutenance",
    "category": "Présentation",
    "description": "Les diapositives présentées devant le jury, lisibles sur téléphone. Bouton « Présenter » pour l’afficher en plein écran.",
    "url": "docs/Presentation_soutenance_TCHAKONDO_Aicha.pdf",
    "file_name": "Presentation_soutenance_TCHAKONDO_Aicha.pdf",
    "mime": "application/pdf",
    "size_bytes": 3106107
  },
  {
    "id": "presentation-pptx",
    "title": "Présentation (fichier PowerPoint)",
    "category": "Présentation",
    "description": "Le fichier PowerPoint original, avec ses animations, à ouvrir dans PowerPoint.",
    "url": "docs/Presentation_soutenance_TCHAKONDO_Aicha.pptx",
    "file_name": "Presentation_soutenance_TCHAKONDO_Aicha.pptx",
    "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "size_bytes": 5641523
  }
],
  // Informations de soutenance par défaut (modifiables depuis l'espace privé)
  defaultSettings: { date: "", time: "", place: "", message: "" }
};
