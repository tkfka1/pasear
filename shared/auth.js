export const CONTROL_SCOPES = ["paseo:read", "paseo:write", "paseo:cancel"];
export const hasControl = (scopes) => CONTROL_SCOPES.every((scope) => scopes.includes(scope));
