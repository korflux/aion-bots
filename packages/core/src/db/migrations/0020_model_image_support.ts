// Resultado opcional de visão. Modelos existentes permanecem sem resultado até uma sonda conclusiva.
import type { Migration } from '../migrator';

export const modelImageSupportMigration: Migration = {
  id: '0020_model_image_support',
  description: 'Resultado tri-state da sonda de visão por modelo',
  up: 'ALTER TABLE model_profiles ADD COLUMN accepts_images boolean;',
  // Só o cache de visão é perdido; favoritos e testes de protocolo continuam intactos.
  rollback: 'ALTER TABLE model_profiles DROP COLUMN IF EXISTS accepts_images;',
};
