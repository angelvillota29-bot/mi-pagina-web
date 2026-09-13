<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
$file = dirname(__DIR__) . '/data/data.json';
if (file_exists($file)) {
    echo file_get_contents($file);
} else {
    echo json_encode(['categories' => [], 'dishes' => [], 'schedule' => [], 'takeoutConfig' => ['enabled' => false, 'fee' => 0], 'brandingConfig' => [], 'usersData' => [], 'n8nConfig' => ['apiKey' => '']]);
}
?>