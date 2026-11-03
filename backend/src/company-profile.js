// Account identity, balance and permissions are never part of a profile update.
export function companyProfileUpdate(body = {}) {
  const invalid = message => Object.assign(new Error(message), { status: 400, code: 'cadastro_empresa_invalido' });
  const text = (key, label, max) => {
    if (typeof body[key] !== 'string') throw invalid(`Preencha ${label}.`);
    const value = body[key].trim().replace(/\s+/g, ' ');
    if (!value || value.length > max || /[<>\u0000-\u001f\u007f]/.test(value)) throw invalid(`Confira ${label} (até ${max} caracteres).`);
    return value;
  };
  const empresa = text('empresa', 'o nome da empresa', 120);
  const responsavel = text('responsavel', 'o responsável', 120);
  const retirada = text('retirada', 'o endereço de retirada', 300);
  if (typeof body.telefoneContato !== 'string' || !/^[+\d\s().-]+$/.test(body.telefoneContato)) throw invalid('Confira o WhatsApp de contato com DDD.');
  let telefoneContato = body.telefoneContato.replace(/\D/g, '');
  if (telefoneContato.length >= 12 && telefoneContato.startsWith('55')) telefoneContato = telefoneContato.slice(2);
  if (!/^[1-9]\d{9,10}$/.test(telefoneContato)) throw invalid('Informe o WhatsApp de contato com DDD (10 ou 11 dígitos).');
  return { empresa, responsavel, retirada, telefoneContato };
}
