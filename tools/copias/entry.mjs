// Solo lo que usa la herramienta de copias (se empaqueta dentro del HTML).
import { generateIdentity, identityToRecipient, Decrypter } from "age-encryption";
window.ageLib = { generateIdentity, identityToRecipient, Decrypter };
