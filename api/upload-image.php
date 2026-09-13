<?php
header('Content-Type: application/json');

// Carpeta donde se guardarán las imágenes
$uploadDir = __DIR__ . '/../uploads/';

// Crear la carpeta si no existe
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_FILES['image'])) {
    $file = $_FILES['image'];
    $error = $file['error'];
    
    if ($error !== UPLOAD_ERR_OK) {
        http_response_code(400);
        echo json_encode(['error' => 'Error al subir el archivo: ' . $error]);
        exit;
    }

    // Validar tipo (solo imágenes)
    $allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);

    if (!in_array($mime, $allowedTypes)) {
        http_response_code(400);
        echo json_encode(['error' => 'Solo se permiten imágenes JPG, JPEG o PNG']);
        exit;
    }

    // Generar nombre único
    $extension = pathinfo($file['name'], PATHINFO_EXTENSION);
    $newName = uniqid() . '.' . $extension;
    $destPath = $uploadDir . $newName;

    if (move_uploaded_file($file['tmp_name'], $destPath)) {
        // URL pública (asumimos que la carpeta uploads está en la raíz)
        $publicUrl = '/uploads/' . $newName;
        echo json_encode(['success' => true, 'url' => $publicUrl]);
    } else {
        http_response_code(500);
        echo json_encode(['error' => 'No se pudo mover el archivo']);
    }
} else {
    http_response_code(405);
    echo json_encode(['error' => 'Método no permitido']);
}
?>