import './auth.css';

/**
 * AuthCard (./AuthCardBase.tsx) with the door pages' card sheet, ./auth.css: the footer's rules, the password toggle's
 * (which /change-password draws without PasswordField) and D16's. S-04 draws none of them and imports ./AuthCardBase
 * itself (the lean frame, owner, 15 Nov 15:35).
 */
export { AuthCard, type AuthCardProps } from './AuthCardBase';
