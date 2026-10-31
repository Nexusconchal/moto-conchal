package br.com.nexusconchal.motoja.motorista;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// A sessão existente fica cifrada no aparelho, com chave do Android Keystore.
final class CallAlertSession {
    static final String BACKEND = "https://motoboy-conchal.onrender.com";
    private static final String ALIAS = "motoja-call-alert-session-v1";
    private static final String PREFS = "motoja_call_alerts";
    private CallAlertSession() {}
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    static synchronized boolean save(Context c, String json) {
        try {
            JSONObject supplied = new JSONObject(json);
            String cpf = supplied.optString("driverCpf"), token = supplied.optString("driverToken");
            if (!cpf.matches("[0-9]{11}") || token.length() < 16 || token.length() > 4096 || !BACKEND.equals(supplied.optString("backend"))) return false;
            JSONObject session = new JSONObject().put("driverCpf", cpf).put("driverToken", token);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(session.toString().getBytes(StandardCharsets.UTF_8));
            prefs(c).edit().putString("cipher", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                    .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).apply();
            return true;
        } catch (Exception ignored) { return false; }
    }
    static JSONObject load(Context c) {
        try {
            SharedPreferences p = prefs(c);
            if (!p.contains("cipher")) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p.getString("iv", ""), Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(p.getString("cipher", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception ignored) { return null; }
    }
    static boolean enabled(Context c) { return prefs(c).getBoolean("enabled", false); }
    static void clear(Context c) { prefs(c).edit().clear().apply(); }
}
